using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Features.PoFighter;

/// <summary>
/// The attract-mode demo's ratings (/pofighter/demo): every completed match between two
/// built-in fighters is one bout on the live fighter Elo board (<c>POST /api/pofighter/elo</c>,
/// the call the tournament makes; start 1000, K 32, a draw is half a point each, no seed rule).
/// </summary>
/// <remarks>
/// demo.js reports a match only from its 'match' event, so a demo left mid-match reports
/// nothing. This class is the other half of the guard: a match number is admitted once (a
/// replayed or re-sent callback cannot count twice), and a Studio fighter, an unknown id or a
/// mirror match is never rated.
/// </remarks>
public sealed class PoFighterDemoElo
{
    private static readonly int Seed = new PairwiseEloOptions().SeedElo;
    private readonly HashSet<int> _reported = [];

    /// <summary>The bout to post for demo match <paramref name="matchNo"/>, or null when it must not count.</summary>
    public PoFighterBoutResultRequest? Admit(int matchNo, string? winnerId, string? loserId, bool isDraw)
    {
        var winner = PoFighterRoster.Canonicalize(winnerId);
        var loser = PoFighterRoster.Canonicalize(loserId);
        if (winner is null || loser is null || winner == loser) return null;
        return _reported.Add(matchNo) ? new PoFighterBoutResultRequest(winner, loser, isDraw) : null;
    }

    /// <summary>
    /// What the win card shows: [winner Elo, its change, loser Elo, its change], from the board
    /// the page held before the bout (<paramref name="before"/>; a fighter not on it was at the
    /// seed) and the ratings the server returned. Null when the server returned nothing usable.
    /// </summary>
    public static int[]? Change(PoFighterBoutResultRequest bout, IReadOnlyDictionary<string, int> before, IReadOnlyList<PoFighterFighterRating>? after)
    {
        ArgumentNullException.ThrowIfNull(bout);
        ArgumentNullException.ThrowIfNull(before);
        var w = after?.FirstOrDefault(r => string.Equals(r.FighterId, bout.WinnerFighterId, StringComparison.OrdinalIgnoreCase));
        var l = after?.FirstOrDefault(r => string.Equals(r.FighterId, bout.LoserFighterId, StringComparison.OrdinalIgnoreCase));
        if (w is null || l is null) return null;
        int Was(string id) => before.TryGetValue(id, out var r) ? r : Seed;
        return [w.Elo, w.Elo - Was(bout.WinnerFighterId), l.Elo, l.Elo - Was(bout.LoserFighterId)];
    }
}
