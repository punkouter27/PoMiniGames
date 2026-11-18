using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// SignalR hub for the PoFunQuiz match. Two-player trivia battle. Pairing is the lobby's job
/// (<see cref="FunQuizLobbyHub"/>); this hub only plays the match the lobby reserved.
/// Authoritative state lives in <see cref="MultiplayerLobbyService"/> (singleton). Clients are
/// pure views driven by <see cref="IFunQuizClient"/> events.
/// </summary>
/// <remarks>
/// <b>No game codes shown.</b> The one entry point is <see cref="JoinMatch"/>, with the internal
/// code the lobby's <c>gameStarted</c> carried; after that no method takes a <c>gameId</c>: the
/// caller's game is resolved from their connection, so a client cannot name a game it isn't in.
/// </remarks>
public class FunQuizHub : Hub<IFunQuizClient>
{
    private readonly MultiplayerLobbyService _lobby;

    public FunQuizHub(MultiplayerLobbyService lobby)
    {
        _lobby = lobby;
    }

    /// <summary>
    /// Claim the seat the lobby reserved for <paramref name="playerName"/> in the match
    /// <paramref name="matchCode"/>. When both seats are claimed the match begins and
    /// <c>GameStarted</c> goes to both players.
    /// </summary>
    public async Task JoinMatch(string matchCode, string playerName)
    {
        var joined = _lobby.JoinMatch(Context.ConnectionId, matchCode ?? string.Empty, playerName ?? string.Empty);
        if (joined is not { } j)
        {
            throw new HubException("That quiz is no longer open. Head back to the lobby.");
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, j.Game.GameId);
        if (j.AllSeated)
        {
            await Clients.Group(j.Game.GameId).GameStarted(BuildState(j.Game));
        }
    }

    public async Task UpdateScore(bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        if (!_lobby.UpdateScore(game.GameId, Context.ConnectionId, isCorrect, speedMultiplier, secondsRemaining)) return;
        var player = game.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (player is null) return;
        await Clients.Group(game.GameId).ScoreUpdated(new FunQuizScoreUpdate(
            game.GameId, player.Name, player.Score, player.CurrentStreak, player.MaxStreak));
    }

    public async Task PlayerFinished()
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        // Mark this player as finished for the *current* question. When both
        // have finished the question, advance. Once we've burned through every
        // question, declare the winner.
        var me = game.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (me is null) return;
        if (me.HasFinished) return; // already submitted for this question
        me.HasFinished = true;
        await Clients.Group(game.GameId).PlayerFinishedQuestion(new FunQuizPlayerFinishedQuestion(
            game.GameId, me.Name, game.Players.Count(p => p.HasFinished), game.Players.Count));

        await AdvanceIfAllFinishedAsync(game);
    }

    /// <summary>
    /// Moves the game on once everyone still in it has answered. "Everyone still in it",
    /// not "both players": when the opponent leaves, the survivor plays the quiz out
    /// instead of waiting forever on an answer that will never come.
    /// </summary>
    private async Task<bool> AdvanceIfAllFinishedAsync(MultiplayerGame game)
    {
        if (game.State != GameState.InProgress || game.Players.Count == 0
            || !game.Players.All(p => p.HasFinished))
        {
            return false;
        }

        if (game.CurrentQuestionIndex >= game.Questions.Count - 1)
        {
            // All questions consumed → declare the final winner.
            _lobby.FinishGame(game.GameId);
            var scores = game.Players.ToDictionary(p => p.Name, p => p.Score);
            var winner = game.Winner;
            var payload = new FunQuizGameFinished(
                game.GameId, scores,
                winner is null ? null : new FunQuizPlayerState(winner.Name, winner.Score, winner.MaxStreak),
                game.IsTie);
            await Clients.Group(game.GameId).GameFinished(payload);
        }
        else
        {
            // Server-driven advance, bypassing the host-only guard on AdvanceQuestion so
            // whichever player answered last can drive the transition. HasFinished is reset
            // inside ForceAdvanceQuestion.
            _lobby.ForceAdvanceQuestion(game.GameId);
            await Clients.Group(game.GameId).GameUpdated(BuildState(game));
        }

        return true;
    }

    public async Task AdvanceQuestion()
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        if (!_lobby.AdvanceQuestion(game.GameId, Context.ConnectionId)) return;
        await Clients.Group(game.GameId).GameUpdated(BuildState(game));
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        _lobby.RemovePlayer(Context.ConnectionId, out var empty);
        if (game is null || empty) return;
        // The survivor may already be waiting on the player who just left.
        if (await AdvanceIfAllFinishedAsync(game)) return;
        await Clients.Group(game.GameId).GameUpdated(BuildState(game));
    }

    private static FunQuizGameState BuildState(MultiplayerGame g) => new(
        g.GameId,
        g.Players.FirstOrDefault(p => p.ConnectionId == g.HostConnectionId)?.Name ?? string.Empty,
        g.State,
        g.Players.Select(p => new FunQuizPlayerState(p.Name, p.Score, p.CurrentStreak)).ToList(),
        g.Questions,
        g.CurrentQuestionIndex,
        g.Category.ToString(),
        SecondsPerQuestion: 30);
}
