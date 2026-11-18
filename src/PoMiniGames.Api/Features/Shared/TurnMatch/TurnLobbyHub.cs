using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// The lobby hub shared by ConnectFive and TicTacToe (each maps its own empty subclass, so each
/// game has its own room and route). First arrival hosts, the guest readies, the host starts.
/// On start the match is reserved NOW on the game's <see cref="TurnMatchService{THub}"/> under an
/// internal code, and only the two seated connections are told (<c>gameStarted</c> carries the
/// code); both clients then <c>JoinMatch</c> on the match hub. The code is never shown.
/// </summary>
public abstract class TurnLobbyHub<TMatchHub> : LobbyHub<TurnLobbyPlayer, TurnLobbyRoom<TMatchHub>>
    where TMatchHub : Hub
{
    private readonly TurnMatchService<TMatchHub> _matches;

    /// <summary>The code OnStartingAsync reserved, for SendGameStartedAsync in the same StartGame call.</summary>
    private string? _startedCode;

    protected TurnLobbyHub(TurnLobbyRoom<TMatchHub> lobby, TurnMatchService<TMatchHub> matches, ILogger log)
        : base(lobby, "turn-lobby-" + typeof(TMatchHub).Name, log)
    {
        _matches = matches;
    }

    protected override string StartingMessage => "Game starting…";

    /// <summary>
    /// Server-canonical identity from the claims; the typed name is only a fallback for a nameless
    /// guest. A full or starting room refuses loudly so the page says why.
    /// </summary>
    protected override (LobbyState<TurnLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var (state, msg) = Lobby.Open(Context.ConnectionId, name, identity.IsGuest || isGuest);
        if (!state.Players.Any(p => p.ConnectionId == Context.ConnectionId))
        {
            throw new HubException($"{msg} — try again in a moment.");
        }
        return (state, msg);
    }

    protected override Task OnStartingAsync(IReadOnlyList<TurnLobbyPlayer> roster)
    {
        if (roster.Count != TurnLobbyRoom<TMatchHub>.Cap)
        {
            throw new HubException("Both players must be seated to start.");
        }
        _startedCode = _matches.Reserve();
        // Free the room for the next pair at once; the players' lobby connections close as they
        // move on to the match hub.
        Lobby.End();
        return Task.CompletedTask;
    }

    /// <summary>The two seated players only — never the lobby group, which holds every visitor.</summary>
    protected override Task SendGameStartedAsync(IReadOnlyList<TurnLobbyPlayer> roster) =>
        _startedCode is null
            ? Task.CompletedTask
            : Clients.Clients(roster.Select(p => p.ConnectionId).ToList()).SendAsync("gameStarted", _startedCode);
}

/// <summary>Online Connect Five lobby, mapped at <c>/connectfive/lobby-hub</c>.</summary>
public sealed class ConnectFiveLobbyHub(
    TurnLobbyRoom<ConnectFiveHub> lobby, TurnMatchService<ConnectFiveHub> matches, ILogger<ConnectFiveLobbyHub> log)
    : TurnLobbyHub<ConnectFiveHub>(lobby, matches, log);

/// <summary>Online Tic-Tac-Toe lobby, mapped at <c>/tictactoe/lobby-hub</c>.</summary>
public sealed class TicTacToeLobbyHub(
    TurnLobbyRoom<TicTacToeHub> lobby, TurnMatchService<TicTacToeHub> matches, ILogger<TicTacToeLobbyHub> log)
    : TurnLobbyHub<TicTacToeHub>(lobby, matches, log);
