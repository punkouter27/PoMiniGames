namespace PoMiniGames.Features.PoCoupleQuiz;

// ── Strongly-typed client interface (compile-time-safe SignalR events) ──────
//
// The lobby is its own hub (CoupleQuizLobbyHub); these are the match events. Payloads carry no
// game code: a match is reached by the internal code the lobby hands both players.

public record GamePlayerState(string Name, bool IsKingPlayer, int Score);

public record GameStartedPayload(
    string KingPlayerName,
    List<GamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundIndex,
    int MaxRounds,
    int RoundSeconds);

public record RoundStartedPayload(
    int RoundIndex,
    int MaxRounds,
    string KingPlayerName,
    List<GamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundSeconds);

public record AnswerRecordedPayload(string PlayerName, int RoundIndex);

public record RoundResultPayload(
    int RoundIndex,
    string KingAnswer,
    List<string> MatchedPlayers,
    Dictionary<string, int> Scores,
    Dictionary<string, string> PlayerAnswers,
    List<GamePlayerState> Players);

public record GameOverPayload(
    IReadOnlyDictionary<string, int> FinalScores,
    List<GamePlayerState> Players);

public interface IGameClient
{
    Task GameStarted(GameStartedPayload payload);
    Task RoundStarted(RoundStartedPayload payload);
    Task AnswerRecorded(AnswerRecordedPayload payload);
    Task RoundResult(RoundResultPayload payload);
    Task GameOver(GameOverPayload payload);
    Task GameError(string message);
}
