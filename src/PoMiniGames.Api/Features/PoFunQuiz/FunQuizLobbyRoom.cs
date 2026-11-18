using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// The Fun Quiz lobby: the shared ready/start room capped at two. The first arrival hosts and
/// picks the category and question count; the guest readies; the host starts. Nobody sees a
/// code: <see cref="GameCode"/> only names the one room.
/// </summary>
public sealed class FunQuizLobbyRoom : LobbyRoom<FunQuizLobbyPlayer>
{
    public const string GlobalCode = "FUNQUIZ";
    public const int Cap = 2;
    public const string DefaultCategory = nameof(QuestionCategory.General);
    public const int DefaultQuestionCount = 10;

    /// <summary>The question counts a host may pick.</summary>
    public static readonly int[] AllowedCounts = [5, 10, 15, 20];

    // The last picks the host made: a new seat starts on them, so a pair coming back from a
    // match (new connections) finds the room as they left it.
    private string _category = DefaultCategory;
    private int _questionCount = DefaultQuestionCount;

    public FunQuizLobbyRoom() : base(GlobalCode, Cap, "A quiz is starting")
    {
    }

    public (LobbyState<FunQuizLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest) =>
        OpenCore(connectionId, displayName, isGuest, (name, existing, others) =>
            new FunQuizLobbyPlayer(connectionId,
                UniqueSeatNames.Make(name, others.Select(o => o.DisplayName)),
                isGuest, existing?.IsReady ?? false, _category, _questionCount));

    /// <summary>Host-only. Returns false (and changes nothing) for anyone else or a bad value.</summary>
    public bool SetOptions(string connectionId, string category, int questionCount) => WithLock(seats =>
    {
        if (HostConnectionId != connectionId) return false;
        if (!Enum.TryParse<QuestionCategory>(category, true, out var parsed) || !Enum.IsDefined(parsed)) return false;
        if (!AllowedCounts.Contains(questionCount)) return false;
        _category = parsed.ToString();
        _questionCount = questionCount;
        foreach (var key in seats.Keys.ToList())
        {
            seats[key] = seats[key] with { Category = _category, QuestionCount = _questionCount };
        }
        return true;
    });

    protected override FunQuizLobbyPlayer WithReady(FunQuizLobbyPlayer player, bool ready) => player with { IsReady = ready };

    /// <summary>Both seats filled and the guest ready; the host starts instead of readying.</summary>
    protected override bool CanStart(IReadOnlyList<FunQuizLobbyPlayer> players, string hostConnectionId) =>
        players.Count == Cap && base.CanStart(players, hostConnectionId);
}
