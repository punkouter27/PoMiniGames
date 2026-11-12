using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// The PoVoxelStrike room: the shared ready/start lobby with a stable 1-based seat number
/// per player. The lockstep runtime keys input batches (and the per-player score RowKey)
/// on that number, so a re-join keeps the seat it had rather than taking the next one.
/// </summary>
public sealed class PoVoxelStrikeLobbyService : LobbyRoom<PoVoxelStrikeLobbyPlayer>
{
    public const string GlobalCode = "VOXELL";

    /// <summary>Per the proposal: 2–4 default, up to 6 supported. The F1 host can sustain 6; above that the desync detector mis-fires under load.</summary>
    public const int Cap = 6;

    public PoVoxelStrikeLobbyService() : base(GlobalCode, Cap, "Run already in progress")
    {
    }

    public (LobbyState<PoVoxelStrikeLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest) =>
        OpenCore(connectionId, displayName, isGuest, (name, existing, others) =>
        {
            // Next free seat after everyone else's; a re-join therefore lands back on its own.
            var seat = existing?.PlayerNumber ?? others.Select(p => p.PlayerNumber).DefaultIfEmpty(0).Max() + 1;
            return new PoVoxelStrikeLobbyPlayer(connectionId, name, isGuest, false, seat);
        });

    protected override PoVoxelStrikeLobbyPlayer WithReady(PoVoxelStrikeLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };
}
