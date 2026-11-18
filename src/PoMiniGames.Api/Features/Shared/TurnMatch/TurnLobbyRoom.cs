using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// The single global lobby for one two-seat turn game (ConnectFive or TicTacToe): the shared
/// ready/start room capped at two, where the first arrival hosts and plays first, the guest
/// readies, and the host starts. One instance per match hub type, so each game has its own
/// room; there is no code or passcode.
/// </summary>
public sealed class TurnLobbyRoom<TMatchHub> : LobbyRoom<TurnLobbyPlayer>
{
    /// <summary>Hard cap: a turn game is exactly two seats.</summary>
    public const int Cap = 2;

    public TurnLobbyRoom() : base("TURN-" + typeof(TMatchHub).Name, Cap, "A game is starting")
    {
    }

    public (LobbyState<TurnLobbyPlayer> state, string message) Open(
        string connectionId, string displayName, bool isGuest) =>
        OpenCore(connectionId, displayName, isGuest,
            (name, existing, _) => new TurnLobbyPlayer(connectionId, name, isGuest, existing?.IsReady ?? false));

    protected override TurnLobbyPlayer WithReady(TurnLobbyPlayer player, bool ready) => player with { IsReady = ready };

    /// <summary>Both seats must be filled and the guest ready; the host starts instead of readying.</summary>
    protected override bool CanStart(IReadOnlyList<TurnLobbyPlayer> players, string hostConnectionId) =>
        players.Count == Cap && players.All(p => p.ConnectionId == hostConnectionId || p.IsReady);
}
