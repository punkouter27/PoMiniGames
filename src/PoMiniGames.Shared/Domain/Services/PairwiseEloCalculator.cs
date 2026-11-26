namespace PoMiniGames.Domain.Services;

/// <summary>
/// Classic head-to-head Elo: two rated opponents meet, both ratings move, and the winner's
/// gain is the loser's loss.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is not <see cref="EloCalculator"/>.</b> That one rates a player against a
/// <em>fixed</em> virtual AI rating per difficulty tier, which buys it a valuable property:
/// the result depends only on the accumulated win/loss/draw counts, so it can be recomputed
/// from scratch at any time and backfilled onto legacy rows. Head-to-head Elo cannot have
/// that property — each match is scored against the opponent's rating <em>at that moment</em>,
/// so the outcome is path-dependent and the stored rating is the only record of the history.
/// Do not try to unify the two; the difference is the point.
/// </para>
/// <para>
/// <b>Zero-sum by construction.</b> The delta is computed once, rounded once, and applied as
/// <c>+d</c> to one side and <c>-d</c> to the other, so the rating pool is conserved exactly
/// and cannot drift from rounding both sides independently. The one exception is
/// <see cref="PairwiseEloOptions.FloorElo"/>: a fighter already at the floor absorbs less than
/// the full loss, and the floor deliberately wins over conservation. Without it a roster
/// outlier left running on an unattended kiosk grinds to a negative rating that reads as a
/// bug on the board.
/// </para>
/// <para>
/// Callers must apply the returned values as <em>increments</em> to whatever the stored
/// rating is at write time, not as absolute values computed from the read. Increments
/// commute, so two demo matches finishing concurrently compose correctly instead of one
/// silently overwriting the other.
/// </para>
/// </remarks>
public sealed class PairwiseEloCalculator
{
    private readonly PairwiseEloOptions _options;

    public PairwiseEloCalculator(PairwiseEloOptions options)
    {
        _options = options;
    }

    /// <summary>The rating a fighter starts at before its first rated match.</summary>
    public int SeedElo => _options.SeedElo;

    /// <summary>
    /// Rating change for a single match between two rated fighters.
    /// </summary>
    /// <param name="winnerRating">Current rating of the fighter that won (or side A on a draw).</param>
    /// <param name="loserRating">Current rating of the fighter that lost (or side B on a draw).</param>
    /// <param name="isDraw">True when neither side won.</param>
    /// <returns>
    /// The delta to add to the winner (side A) and to subtract from the loser (side B).
    /// Negative on a draw when side A was the higher-rated fighter — a draw against a weaker
    /// opponent is a rating loss, which is correct Elo behaviour and not a sign error.
    /// </returns>
    public int Delta(int winnerRating, int loserRating, bool isDraw)
    {
        var expected = EloMath.ExpectedScore(winnerRating, loserRating);
        var actual = isDraw ? 0.5 : 1.0;

        // MidpointRounding.AwayFromZero so a ±0.5 delta is never rounded to nothing; banker's
        // rounding here would quietly discard the smallest real rating movements.
        return EloMath.Delta(expected, actual, _options.K, MidpointRounding.AwayFromZero);
    }

    /// <summary>
    /// Applies a delta to a stored rating, honouring the floor. Use this rather than raw
    /// addition so every write path clamps identically.
    /// </summary>
    public int ApplyDelta(int currentRating, int delta) =>
        Math.Max(_options.FloorElo, currentRating + delta);
}
