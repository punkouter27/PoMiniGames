using PoMiniGames.Domain.Models;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Features.PoMule;

/// <summary>What the rules say a replayed match ended at, for the human's seat.</summary>
public readonly record struct PoMuleReplayed(int NetWorth, bool ColonySurvived);

/// <summary>
/// Replays a PoMule match from the seed and action log the client sends with its score, so the
/// board keeps the server's Net Worth. Unlike PoMarbleRace (cannon-es, no server physics), PoMule's
/// whole rules engine is deterministic C# in PoMiniGames.Shared, the same code the browser ran, so
/// this is a full re-run rather than a plausibility bound.
/// </summary>
/// <remarks>
/// What it cannot prove: that the seed was random, or that the AI arrivals the renderer reported
/// came from honest walking. Both are bounded by the rules (an arrival only performs the AI's own
/// next errand) and by the play-session guard.
/// </remarks>
public static class PoMuleRunVerifier
{
    /// <returns>The replayed result, or null when the log is malformed or never finishes the match.</returns>
    public static PoMuleReplayed? Replay(ulong seed, int species, bool classic, string? log)
    {
        if (species < 0 || species >= PoMuleSpecies.All.Count) return null;
        var match = PoMuleReplay.Run(seed, (Species)species, classic, log);
        if (match is null) return null;
        var standings = PoMuleScoring.Standings(match.State);
        var mine = standings.First(s => s.Seat == 0).NetWorth;
        return new PoMuleReplayed(
            Math.Clamp(mine, PoMuleHighScore.MinNetWorth, PoMuleHighScore.MaxNetWorth),
            PoMuleScoring.ColonySurvives(standings.Sum(s => s.NetWorth), match.State.CrisisMonths));
    }
}
