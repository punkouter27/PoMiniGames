using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// The Couple Quiz lobby: the shared ready/start room capped at two. The first arrival hosts and
/// picks the round count and topic pack; the guest readies; the host starts. Nobody sees a code.
/// </summary>
public sealed class CoupleQuizLobbyRoom : LobbyRoom<CoupleQuizLobbyPlayer>
{
    public const string GlobalCode = "COUPLEQUIZ";
    public const int Cap = 2;

    // The last picks the host made: a new seat starts on them (see FunQuizLobbyRoom).
    private int _rounds = Game.DefaultRounds;
    private string _topicPack = "Classic";

    public CoupleQuizLobbyRoom() : base(GlobalCode, Cap, "A quiz is starting")
    {
    }

    public (LobbyState<CoupleQuizLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest) =>
        OpenCore(connectionId, displayName, isGuest, (name, existing, others) =>
            new CoupleQuizLobbyPlayer(connectionId,
                UniqueSeatNames.Make(name, others.Select(o => o.DisplayName)),
                isGuest, existing?.IsReady ?? false, _rounds, _topicPack));

    /// <summary>Host-only. Returns false (and changes nothing) for anyone else or a value off the menu.</summary>
    public bool SetRounds(string connectionId, int rounds) => WithLock(seats =>
    {
        if (HostConnectionId != connectionId || !Game.AllowedRounds.Contains(rounds)) return false;
        _rounds = rounds;
        foreach (var key in seats.Keys.ToList()) seats[key] = seats[key] with { Rounds = rounds };
        return true;
    });

    /// <summary>Host-only. Returns false for anyone else or an unknown pack.</summary>
    public bool SetTopicPack(string connectionId, string topicPack) => WithLock(seats =>
    {
        if (HostConnectionId != connectionId || !CoupleQuizExternalPackService.IsValidPack(topicPack)) return false;
        _topicPack = CoupleQuizExternalPackService.NormalizePack(topicPack);
        foreach (var key in seats.Keys.ToList()) seats[key] = seats[key] with { TopicPack = _topicPack };
        return true;
    });

    protected override CoupleQuizLobbyPlayer WithReady(CoupleQuizLobbyPlayer player, bool ready) => player with { IsReady = ready };

    /// <summary>Both seats filled and the guest ready; the host starts instead of readying.</summary>
    protected override bool CanStart(IReadOnlyList<CoupleQuizLobbyPlayer> players, string hostConnectionId) =>
        players.Count == Cap && base.CanStart(players, hostConnectionId);
}
