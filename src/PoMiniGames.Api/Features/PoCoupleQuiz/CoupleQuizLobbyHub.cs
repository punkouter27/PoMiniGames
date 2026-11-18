using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// The Couple Quiz room over the shared lobby hub (<c>/couplequiz/lobby-hub</c>). The
/// game-specific steps: the host's rounds and topic pack, and reserving the match on
/// <see cref="GameSessionManager"/> the instant the host starts, so both browsers can join the
/// game hub (<c>/couplequiz/hubs/game</c>) by the internal code <c>gameStarted</c> carries.
/// </summary>
public sealed class CoupleQuizLobbyHub : LobbyHub<CoupleQuizLobbyPlayer, CoupleQuizLobbyRoom>
{
    private readonly GameSessionManager _sessions;

    /// <summary>The code OnStartingAsync reserved, for SendGameStartedAsync in the same StartGame call.</summary>
    private string? _startedCode;

    public CoupleQuizLobbyHub(CoupleQuizLobbyRoom lobby, GameSessionManager sessions, ILogger<CoupleQuizLobbyHub> log)
        : base(lobby, "couplequiz-lobby", log)
    {
        _sessions = sessions;
    }

    protected override string StartingMessage => "Quiz starting…";

    protected override (LobbyState<CoupleQuizLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
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

    /// <summary>Host-only: 3, 5 or 7 rounds. Ignored from anyone else.</summary>
    public async Task SetRounds(int rounds)
    {
        if (Lobby.SetRounds(Context.ConnectionId, rounds)) await BroadcastStateAsync();
    }

    /// <summary>Host-only: topic pack (Classic, WordSync, WorldTravel, BooksAndStories, Mixed).</summary>
    public async Task SetTopicPack(string topicPack)
    {
        if (Lobby.SetTopicPack(Context.ConnectionId, topicPack)) await BroadcastStateAsync();
    }

    protected override Task OnStartingAsync(IReadOnlyList<CoupleQuizLobbyPlayer> roster)
    {
        if (roster.Count != CoupleQuizLobbyRoom.Cap)
        {
            throw new HubException("Both players must be seated to start.");
        }
        var host = roster.First(p => p.ConnectionId == Lobby.HostConnectionId);
        var names = new[] { host.DisplayName }.Concat(roster.Where(p => p != host).Select(p => p.DisplayName)).ToList();
        _startedCode = _sessions.Reserve(names, host.Rounds, host.TopicPack)
            ?? throw new HubException("A quiz is already being played. Try again in a minute.");
        // Free the room for the next pair at once; the lobby connections close as the players
        // move on to the game hub.
        Lobby.End();
        return Task.CompletedTask;
    }

    /// <summary>The two seated players only — never the lobby group, which holds every visitor.</summary>
    protected override Task SendGameStartedAsync(IReadOnlyList<CoupleQuizLobbyPlayer> roster) =>
        _startedCode is null
            ? Task.CompletedTask
            : Clients.Clients(roster.Select(p => p.ConnectionId).ToList()).SendAsync("gameStarted", _startedCode);
}
