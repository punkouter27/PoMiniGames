using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// The Fun Quiz room over the shared lobby hub (<c>/funquiz/lobby-hub</c>). The game-specific
/// steps: the host's category and question count (<see cref="SetOptions"/>), and reserving the
/// match on <see cref="MultiplayerLobbyService"/> the instant the host starts, so both
/// browsers can join the game hub (<c>/funquiz/gamehub</c>) by the internal code
/// <c>gameStarted</c> carries. Only the two seated connections are told.
/// </summary>
public sealed class FunQuizLobbyHub : LobbyHub<FunQuizLobbyPlayer, FunQuizLobbyRoom>
{
    private readonly MultiplayerLobbyService _matches;

    /// <summary>The code OnStartingAsync reserved, for SendGameStartedAsync in the same StartGame call.</summary>
    private string? _startedCode;

    public FunQuizLobbyHub(FunQuizLobbyRoom lobby, MultiplayerLobbyService matches, ILogger<FunQuizLobbyHub> log)
        : base(lobby, "funquiz-lobby", log)
    {
        _matches = matches;
    }

    protected override string StartingMessage => "Quiz starting…";

    protected override (LobbyState<FunQuizLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
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

    /// <summary>The host's category and question count. Ignored from anyone else.</summary>
    public async Task SetOptions(string category, int questionCount)
    {
        if (Lobby.SetOptions(Context.ConnectionId, category, questionCount))
            await BroadcastStateAsync();
    }

    protected override async Task OnStartingAsync(IReadOnlyList<FunQuizLobbyPlayer> roster)
    {
        if (roster.Count != FunQuizLobbyRoom.Cap)
        {
            throw new HubException("Both players must be seated to start.");
        }
        var host = roster.First(p => p.ConnectionId == Lobby.HostConnectionId);
        var guest = roster.First(p => p.ConnectionId != host.ConnectionId);
        var category = Enum.TryParse<QuestionCategory>(host.Category, true, out var c) ? c : QuestionCategory.General;
        _startedCode = await _matches.ReserveAsync(host.DisplayName, guest.DisplayName, category, host.QuestionCount, Context.ConnectionAborted);
        // Free the room for the next pair at once; the players' lobby connections close as they
        // move on to the game hub.
        Lobby.End();
    }

    /// <summary>The two seated players only — never the lobby group, which holds every visitor.</summary>
    protected override Task SendGameStartedAsync(IReadOnlyList<FunQuizLobbyPlayer> roster) =>
        _startedCode is null
            ? Task.CompletedTask
            : Clients.Clients(roster.Select(p => p.ConnectionId).ToList()).SendAsync("gameStarted", _startedCode);
}
