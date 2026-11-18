using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// SignalR hub for the PoCoupleQuiz match. Pairing is the lobby's job
/// (<see cref="CoupleQuizLobbyHub"/>); this hub claims the reserved seats, takes answers, and
/// delegates every round transition to <see cref="CoupleQuizRoundDirector"/>.
/// </summary>
/// <remarks>
/// <para>Authoritative state lives in <see cref="GameSessionManager"/> (singleton). Clients are
/// pure views driven by <see cref="IGameClient"/> events.</para>
///
/// <para>There is one live match per process, so every broadcast targets
/// <c>Clients.All</c> and no SignalR group is needed. The round clock is driven by the server,
/// not a player.</para>
/// </remarks>
public class CoupleQuizHub : Hub<IGameClient>
{
    private readonly GameSessionManager _sessions;
    private readonly CoupleQuizRoundDirector _director;

    public CoupleQuizHub(GameSessionManager sessions, CoupleQuizRoundDirector director)
    {
        _sessions = sessions;
        _director = director;
    }

    /// <summary>
    /// Claim the seat the lobby reserved for <paramref name="playerName"/> in the match
    /// <paramref name="matchCode"/>. The match begins once both seats are claimed.
    /// </summary>
    public async Task JoinMatch(string matchCode, string playerName)
    {
        var joined = _sessions.JoinMatch(Context.ConnectionId, matchCode ?? string.Empty, playerName ?? string.Empty);
        if (joined is not { } j)
        {
            throw new HubException("That quiz is no longer open. Head back to the lobby.");
        }
        if (j.AllSeated)
        {
            await _director.StartGameAsync(Context.ConnectionAborted);
        }
    }

    // ── Game phase ──────────────────────────────────────────────────────

    public async Task SubmitAnswer(string answer)
    {
        var session = _sessions.GetSessionByConnection(Context.ConnectionId);
        var me = session?.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (me is null) return;

        await _director.SubmitAnswerAsync(me.Name, answer, Context.ConnectionAborted);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var session = _sessions.RemovePlayer(Context.ConnectionId, out var sessionEmpty);
        if (session is null || sessionEmpty) return;

        // The leaver may have been the last person the round was waiting on.
        await _director.OnPlayerLeftAsync();
    }
}
