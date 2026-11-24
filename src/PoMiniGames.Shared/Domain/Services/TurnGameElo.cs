namespace PoMiniGames.Domain.Services;

/// <summary>
/// Standard head-to-head Elo for online turn games (Connect Five): K = 32, new players start
/// at 1200, and the exchange is zero-sum. Kept apart from the adaptive 1P rating
/// (<see cref="EloCalculator"/>), which rates play against the CPU only.
/// </summary>
public static class TurnGameElo
{
    public const int StartRating = 1200;
    public const double K = 32;

    /// <summary>
    /// Rating change for the first player when it scores <paramref name="scoreFirst"/>
    /// (1 win, 0.5 draw, 0 loss) against the second. The second player's change is the negative.
    /// </summary>
    public static int DeltaForFirst(int ratingFirst, int ratingSecond, double scoreFirst) =>
        EloMath.Delta(EloMath.ExpectedScore(ratingFirst, ratingSecond), scoreFirst, K, MidpointRounding.AwayFromZero);
}
