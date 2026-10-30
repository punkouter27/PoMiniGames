namespace PoMiniGames.Features.PoCoupleQuiz;

// ── Enums ───────────────────────────────────────────────────────────────────

public enum SessionState
{
    Waiting,
    InProgress,
    Finished
}

public enum QuestionCategory
{
    Relationships,
    Hobbies,
    Childhood,
    Future,
    Preferences,
    Values
}

/// <summary>What the lobby is doing right now. Drives the single per-session timer.</summary>
public enum RoundPhase
{
    /// <summary>Question is live; everyone is typing.</summary>
    Answering,
    /// <summary>The round has been scored and the result is on screen.</summary>
    Revealing
}

// ── Player & Question ───────────────────────────────────────────────────────

public class Player
{
    public string Name { get; set; } = string.Empty;
    public int Score { get; set; }
    public int TotalRoundsPlayed { get; set; }
    public int TotalCorrectGuesses { get; set; }
}

public class Question
{
    public string Text { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; }
}

public class GameQuestion
{
    public string Text { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; }
    public string? KingPlayerAnswer { get; set; }
    public Dictionary<string, string> PlayerAnswers { get; set; } = new();

    public bool HasPlayerAnswered(string playerName) => PlayerAnswers.ContainsKey(playerName);
}

public class Game
{
    /// <summary>Legal round counts a host may pick in the lobby. 5 is the default.</summary>
    public static readonly int[] AllowedRounds = [3, 5, 7];

    public const int DefaultRounds = 5;

    public List<Player> Players { get; set; } = new();

    /// <summary>
    /// The question on screen right now. Reused in place from round to round — only one
    /// question is ever live and no history is kept.
    /// </summary>
    /// <remarks>
    /// This was a <c>List&lt;GameQuestion&gt; Questions</c> that only ever received ONE
    /// element (in <c>StartGame</c>); later rounds overwrote that element's fields rather
    /// than appending. <c>AllPlayersAnswered</c> indexed the list by round number, so from
    /// round 1 onward it read past the end and always answered false. Nothing noticed while
    /// the host advanced rounds by hand; the moment round completion was automated, every
    /// round after the first stopped ending early and sat out its full deadline instead.
    /// </remarks>
    public GameQuestion? CurrentQuestion { get; set; }

    public int CurrentRound { get; set; }
    public int MaxRounds { get; set; } = DefaultRounds;

    /// <summary>
    /// The King ROTATES: player <c>CurrentRound % Players.Count</c> is the subject of the
    /// round, everyone else guesses.
    /// </summary>
    /// <remarks>
    /// It used to be pinned to index 0 for the whole game while <see cref="GetScoreboard"/>
    /// excluded the King from scoring — so in the two-player game this is actually built for,
    /// one partner was a permanent non-competitor who finished every match with no score, no
    /// match-history row and no profile result. Rotation makes the score mean "how often you
    /// guessed your partner right", which is the thing a couple quiz is measuring, and every
    /// player takes an equal number of turns as subject.
    /// </remarks>
    public int CurrentKingPlayerIndex => Players.Count == 0 ? 0 : CurrentRound % Players.Count;

    public Player? KingPlayer => Players.Count == 0 ? null : Players[CurrentKingPlayerIndex];

    public bool IsKing(string playerName) =>
        string.Equals(KingPlayer?.Name, playerName, StringComparison.Ordinal);

    public bool IsGameOver => CurrentRound >= MaxRounds;

    public const int MinimumPlayers = 2;

    public bool HasEnoughPlayers => Players.Count >= MinimumPlayers;

    /// <summary>
    /// Every player's running score, highest first. The King of the CURRENT round is included:
    /// scores accumulate across rounds and the King seat rotates, so excluding them would blank
    /// out a real total for one round in every N.
    /// </summary>
    public Dictionary<string, int> GetScoreboard() =>
        Players.OrderByDescending(p => p.Score)
               .ToDictionary(p => p.Name, p => p.Score);

    public void AddPlayer(Player player) => Players.Add(player);

    /// <summary>True once the King and every guesser have submitted for the live round.</summary>
    public bool AllPlayersAnswered() =>
        CurrentQuestion is { } question
        && question.KingPlayerAnswer is not null
        && Players.Where(p => !IsKing(p.Name)).All(p => question.HasPlayerAnswered(p.Name));
}

// ── Session (in-memory lobby state, not persisted) ──────────────────────────

public record LobbyPlayer(string Name, string ConnectionId);

/// <summary>
/// The single process-wide lobby. There is exactly one; see <see cref="GameSessionManager"/>
/// for why game codes were removed.
/// </summary>
public class GameSession
{
    public string HostConnectionId { get; set; } = string.Empty;
    public int MaxRounds { get; set; } = Game.DefaultRounds;
    public SessionState State { get; set; } = SessionState.Waiting;
    public List<LobbyPlayer> Players { get; set; } = new();
    public Game? ActiveGame { get; set; }
    public HashSet<string> ReadyConnectionIds { get; set; } = new(StringComparer.Ordinal);
    public string? HostName => Players.FirstOrDefault(p => p.ConnectionId == HostConnectionId)?.Name;

    // ── Round driver state (owned by CoupleQuizRoundDirector) ───────────────

    /// <summary>Answering or Revealing. The per-session timer means a different thing in each.</summary>
    public RoundPhase Phase { get; set; } = RoundPhase.Answering;

    /// <summary>
    /// Highest round index already scored. The guard against evaluating a round twice when the
    /// last answer and the round deadline land at the same moment.
    /// </summary>
    public int LastEvaluatedRound { get; set; } = -1;

    /// <summary>Bank questions already asked this match, so a match never repeats one.
    public HashSet<string> AskedQuestions { get; } = new(StringComparer.Ordinal);

    /// <summary>Single-shot timer for the current phase. Rearmed on every transition.</summary>
    public Timer? PhaseTimer { get; set; }

    public void DisarmTimer()
    {
        PhaseTimer?.Dispose();
        PhaseTimer = null;
    }
}

public record LobbyReadyState(
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    int MaxRounds,
    bool AllReady,
    int MinPlayersToStart);
