using PoMiniGames.Domain.Models;

namespace PoMiniGames.Domain.Services;

/// <summary>
/// Computes deterministic ELO-style ratings per difficulty tier.
///
/// Strategy: treat every game against the AI as a match against a fixed-rating
/// opponent (no path-dependency). This lets us recompute ELO at any time from
/// the accumulated win/loss/draw counts alone, making the value fully deterministic
/// and safe to backfill for legacy records.
///
/// AI virtual ratings:  Easy = 800 | Medium = 1200 | Hard = 1600
/// Player reference ELO: 1000  (fixed — not the player's current ELO)
/// K factor: 32
///
/// Per-game delta = K × (actual − expected)
///   where expected E = 1 / (1 + 10^((aiElo − 1000) / 400))
///
/// Resulting rounded deltas:
///   Easy   — Win: +8  | Draw: −8  | Loss: −24
///   Medium — Win: +24 | Draw: +8  | Loss: −8
///   Hard   — Win: +31 | Draw: +15 | Loss: −1
///
/// EloRating is floored at 0.
/// </summary>
public sealed class EloCalculator
{
    private readonly EloOptions _options;

    public EloCalculator(EloOptions options)
    {
        _options = options;
    }

    /// <summary>
    /// Computes and sets EloRating on all three difficulty buckets of the given stats object.
    /// Safe to call repeatedly — always deterministic.
    /// </summary>
    public void ApplyAll(PlayerStats stats)
    {
        stats.Easy.EloRating = Compute(stats.Easy, _options.EasyAiElo);
        stats.Medium.EloRating = Compute(stats.Medium, _options.MediumAiElo);
        stats.Hard.EloRating = Compute(stats.Hard, _options.HardAiElo);
    }

    /// <summary>
    /// Computes ELO for a single difficulty bucket against an AI of the given virtual rating.
    /// </summary>
    public int Compute(DifficultyStats ds, int aiElo)
    {
        if (ds.TotalGames == 0)
        {
            return _options.PlayerReferenceElo;
        }

        // Expected score for the player at the reference ELO vs this AI tier.
        double expected = EloMath.ExpectedScore(_options.PlayerReferenceElo, aiElo);

        double elo = _options.PlayerReferenceElo
            + ds.Wins * _options.K * (1.0 - expected) // Win actual=1
            + ds.Draws * _options.K * (0.5 - expected) // Draw actual=0.5
            + ds.Losses * _options.K * (0.0 - expected); // Loss actual=0

        return Math.Max(0, (int)Math.Round(elo));
    }
}
