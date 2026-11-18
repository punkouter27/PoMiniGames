namespace PoMiniGames.Features.PoFunQuiz;

// ── Strongly-typed client interface ─────────────────────────────────────────

public record FunQuizPlayerState(string Name, int Score, int Streak);

public record FunQuizGameState(
    string GameId,
    string HostName,
    GameState State,
    List<FunQuizPlayerState> Players,
    List<QuizQuestion> Questions,
    int CurrentQuestionIndex,
    string Category,
    int SecondsPerQuestion);

public record FunQuizScoreUpdate(string GameId, string PlayerName, int TotalScore, int Streak, int MaxStreak);

/// <summary>
/// Per-question "I'm done" broadcast. <paramref name="finishedCount"/> /
/// <paramref name="totalPlayers"/> drives the lobby UI ("1/2 answered") so
/// players know when the next question is about to drop.
/// </summary>
public record FunQuizPlayerFinishedQuestion(string GameId, string PlayerName, int FinishedCount, int TotalPlayers);

public record FunQuizGameFinished(
    string GameId,
    IReadOnlyDictionary<string, int> FinalScores,
    FunQuizPlayerState? Winner,
    bool IsTie);

public interface IFunQuizClient
{
    // The lobby is its own hub (FunQuizLobbyHub); these are the match events.
    Task GameUpdated(FunQuizGameState state);
    Task GameStarted(FunQuizGameState state);
    Task ScoreUpdated(FunQuizScoreUpdate update);
    Task PlayerFinishedQuestion(FunQuizPlayerFinishedQuestion payload);
    Task GameFinished(FunQuizGameFinished payload);
}
