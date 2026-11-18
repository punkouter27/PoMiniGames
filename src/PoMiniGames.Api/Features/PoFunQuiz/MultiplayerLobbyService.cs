using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// In-memory registry of PoFunQuiz multiplayer matches. Sessions do NOT survive restarts.
/// </summary>
/// <remarks>
/// <para><b>One lobby, no game codes.</b> Pairing happens in <see cref="FunQuizLobbyHub"/>. When
/// its host starts, the lobby calls <see cref="ReserveAsync"/>, which deals the questions and
/// opens a match under an internal code (<see cref="MultiplayerGame.GameId"/>, also the SignalR
/// group key and log correlation id; never shown, never typed in). Each of the two seated
/// players then claims their seat with <see cref="JoinMatch"/>, and the match begins when both
/// have. A reservation nobody claims is dropped by the next <see cref="ReserveAsync"/>.</para>
/// </remarks>
public class MultiplayerLobbyService(IFunQuizQuestionSource questions, ILogger<MultiplayerLobbyService> logger)
{
    /// <summary>How long an unclaimed reservation lives before the next reservation sweeps it.</summary>
    public static readonly TimeSpan ReservationLifetime = TimeSpan.FromMinutes(2);

    private readonly ConcurrentDictionary<string, MultiplayerGame> _games = new();
    private readonly ConcurrentDictionary<string, string> _connectionToGame = new();
    private readonly IFunQuizQuestionSource _questions = questions;
    private readonly ILogger<MultiplayerLobbyService> _logger = logger;

    // Guards match *membership* (seat claim, removal): MultiplayerGame.Players is a plain List
    // whose "is this seat free?" check and its Add must be atomic together.
    private readonly Lock _gate = new();

    /// <summary>
    /// Reserve a match for the two lobby seats (host first) and return its internal code. The
    /// questions are dealt now, from the in-memory bank, for the host's category and count.
    /// </summary>
    public async Task<string> ReserveAsync(
        string hostName, string guestName, QuestionCategory category, int questionCount, CancellationToken ct)
    {
        questionCount = Math.Clamp(questionCount, 1, 50);
        var dealt = (await _questions.GetQuestionsAsync(category, questionCount, ct)).ToList();
        var game = new MultiplayerGame
        {
            GameId = "match-" + Guid.NewGuid().ToString("N"),
            Category = category,
            State = GameState.Waiting,
            ExpectedNames = [hostName, guestName],
            Questions = dealt
        };
        lock (_gate)
        {
            var cutoff = DateTime.UtcNow - ReservationLifetime;
            foreach (var stale in _games.Values.Where(g => g.State == GameState.Waiting && g.ReservedAtUtc < cutoff).ToList())
            {
                _games.TryRemove(stale.GameId, out _);
                foreach (var p in stale.Players) _connectionToGame.TryRemove(p.ConnectionId, out _);
            }
            _games[game.GameId] = game;
        }
        _logger.GameCreated(game.GameId, hostName);
        return game.GameId;
    }

    /// <summary>
    /// Claim the reserved seat named <paramref name="playerName"/> in the match
    /// <paramref name="matchCode"/>. Returns null when the code is unknown, the name is not one of
    /// the reserved seats, or that seat is already taken. The match starts (and
    /// <c>AllSeated</c> is true) when the last reserved seat is claimed.
    /// </summary>
    public (MultiplayerGame Game, bool AllSeated)? JoinMatch(string connectionId, string matchCode, string playerName)
    {
        lock (_gate)
        {
            // A connection that claims again leaves its previous match first.
            RemovePlayerLocked(connectionId, out _);
            if (!_games.TryGetValue(matchCode, out var game) || game.State != GameState.Waiting) return null;
            var index = game.ExpectedNames.FindIndex(n => string.Equals(n, playerName, StringComparison.Ordinal));
            if (index < 0 || game.Players.Any(p => p.PlayerNumber == index + 1)) return null;
            game.Players.Add(new MultiplayerPlayer
            {
                ConnectionId = connectionId,
                Name = game.ExpectedNames[index],
                PlayerNumber = index + 1
            });
            game.Players.Sort((a, b) => a.PlayerNumber.CompareTo(b.PlayerNumber));
            if (index == 0) game.HostConnectionId = connectionId;
            _connectionToGame[connectionId] = game.GameId;
            var allSeated = game.Players.Count == game.ExpectedNames.Count;
            if (allSeated)
            {
                game.State = GameState.InProgress;
                game.StartTime = DateTime.UtcNow;
            }
            _logger.PlayerJoined(game.GameId, game.ExpectedNames[index]);
            return (game, allSeated);
        }
    }

    public MultiplayerGame? GetByConnection(string connectionId) =>
        _connectionToGame.TryGetValue(connectionId, out var id) && _games.TryGetValue(id, out var g) ? g : null;

    public void RemovePlayer(string connectionId, out bool sessionEmpty)
    {
        lock (_gate) RemovePlayerLocked(connectionId, out sessionEmpty);
    }

    private void RemovePlayerLocked(string connectionId, out bool sessionEmpty)
    {
        sessionEmpty = false;
        if (!_connectionToGame.TryRemove(connectionId, out var gameId)) return;
        if (!_games.TryGetValue(gameId, out var game)) return;
        game.Players.RemoveAll(p => p.ConnectionId == connectionId);
        if (game.Players.Count == 0)
        {
            _games.TryRemove(gameId, out _);
            sessionEmpty = true;
            return;
        }
        // Host left → promote the remaining player to host.
        if (game.HostConnectionId == connectionId)
        {
            game.HostConnectionId = game.Players[0].ConnectionId;
        }
    }

    public bool UpdateScore(string gameId, string connectionId, bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        var player = game.Players.FirstOrDefault(p => p.ConnectionId == connectionId);
        if (player is null) return false;
        if (game.Questions.Count == 0) return false;
        // One scoring call per question, and both bonuses bounded: these arrive from the client.
        if (player.HasFinished) return false;
        speedMultiplier = double.IsFinite(speedMultiplier) ? Math.Clamp(speedMultiplier, 1.0, 2.0) : 1.0;
        secondsRemaining = Math.Clamp(secondsRemaining, 0, 30);
        var basePoints = game.Questions[Math.Min(game.CurrentQuestionIndex, game.Questions.Count - 1)].BasePoints;
        if (isCorrect)
        {
            player.ScoreState.ApplyCorrectAnswer(basePoints, speedMultiplier);
            player.ScoreState.SetTimeBonus(player.ScoreState.TimeBonus + (int)Math.Round((double)secondsRemaining * 10));
        }
        else
        {
            player.ScoreState.ResetStreak();
        }
        player.Score = player.ScoreState.TotalScore;
        return true;
    }

    public bool AdvanceQuestion(string gameId, string requesterConnectionId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.HostConnectionId != requesterConnectionId) return false;
        game.CurrentQuestionIndex++;
        // Reset per-question flags so a player
        // who already answered can submit their next answer for the new
        // question. Without this, PlayerFinished() in the hub returns early
        // after the first question because HasFinished was set permanently.
        foreach (var p in game.Players) p.HasFinished = false;
        return true;
    }

    /// <summary>
    /// Server-driven advance — used by the hub when both players have
    /// finished a question and the game state machine wants to move on.
    /// Bypasses the host-only guard on <see cref="AdvanceQuestion"/> so the
    /// transition fires regardless of which player submitted last.
    /// </summary>
    public bool ForceAdvanceQuestion(string gameId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.CurrentQuestionIndex >= game.Questions.Count - 1) return false;
        game.CurrentQuestionIndex++;
        foreach (var p in game.Players) p.HasFinished = false;
        return true;
    }

    public bool FinishGame(string gameId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        game.State = GameState.Finished;
        game.EndTime = DateTime.UtcNow;
        return true;
    }
}

public class MultiplayerPlayer
{
    public string ConnectionId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int PlayerNumber { get; set; }
    public int Score { get; set; }
    public PlayerScoreState ScoreState { get; } = new();
    public int CurrentStreak => ScoreState.CurrentStreak;
    public int MaxStreak => ScoreState.MaxStreak;
    public bool HasFinished { get; set; }
}

public class MultiplayerGame
{
    public string GameId { get; set; } = string.Empty;
    public string HostConnectionId { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; } = QuestionCategory.General;
    /// <summary>The lobby's two seat names, host first; a seat is claimed by <see cref="MultiplayerLobbyService.JoinMatch"/>.</summary>
    public List<string> ExpectedNames { get; set; } = new();
    public DateTime ReservedAtUtc { get; set; } = DateTime.UtcNow;
    public List<QuizQuestion> Questions { get; set; } = new();
    public List<MultiplayerPlayer> Players { get; set; } = new();
    public GameState State { get; set; } = GameState.Waiting;
    public int CurrentQuestionIndex { get; set; }
    public DateTime? StartTime { get; set; }
    public DateTime? EndTime { get; set; }
    public bool IsComplete => State == GameState.Finished || CurrentQuestionIndex >= Questions.Count;
    public MultiplayerPlayer? Winner =>
        Players.Count == 0 || IsTie ? null :
        Players.OrderByDescending(p => p.Score).First();
    public bool IsTie => Players.Count == 2 && Players[0].Score == Players[1].Score;
}
