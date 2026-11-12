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

public record FunQuizLobbySummary(
    string GameId,
    string HostName,
    List<string> Players,
    int PlayerCount,
    GameState State,
    string Category);

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

public record FunQuizLobbyPlayerJoined(string GameId, string PlayerName, List<string> Players);

public record FunQuizLobbyError(string GameCode, string Message);

public interface IFunQuizClient
{
    // Lobby presence
    Task GameCreated(FunQuizGameState state);
    Task GameJoined(FunQuizGameState state);
    Task GameUpdated(FunQuizGameState state);
    Task GameStarted(FunQuizGameState state);
    Task ScoreUpdated(FunQuizScoreUpdate update);
    Task PlayerJoined(FunQuizLobbyPlayerJoined payload);
    Task PlayerFinishedQuestion(FunQuizPlayerFinishedQuestion payload);
    Task GameFinished(FunQuizGameFinished payload);
    Task LobbyError(FunQuizLobbyError error);
}
