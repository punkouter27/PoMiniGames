namespace PoMiniGames.Domain.Services;

/// <summary>
/// Pure mathematical core for Elo rating calculations.
/// Implements the standard logistic distribution curve shared by virtual AI rating
/// calculations (<see cref="EloCalculator"/>) and pairwise fighter matches (<see cref="PairwiseEloCalculator"/>).
/// </summary>
public static class EloMath
{
    /// <summary>
    /// Computes the expected score \(E_A \in (0, 1)\) for an entity with rating <paramref name="ratingA"/>
    /// facing an opponent with rating <paramref name="ratingB"/>:
    /// \[
    ///   E_A = \frac{1}{1 + 10^{(R_B - R_A)/400}}
    /// \]
    /// </summary>
    public static double ExpectedScore(int ratingA, int ratingB) =>
        1.0 / (1.0 + Math.Pow(10, (ratingB - ratingA) / 400.0));

    /// <summary>
    /// Computes the rating delta:
    /// \[
    ///   \Delta = K \times (\text{actual} - \text{expected})
    /// \]
    /// </summary>
    public static int Delta(double expected, double actual, double k, MidpointRounding rounding = MidpointRounding.ToEven) =>
        (int)Math.Round(k * (actual - expected), rounding);
}

