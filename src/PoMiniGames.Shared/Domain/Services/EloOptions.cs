namespace PoMiniGames.Domain.Services;

/// <summary>
/// Configuration options for ELO rating computation.
/// Bound from the "PoMiniGames:Elo" configuration section.
/// </summary>
public class EloOptions
{
    public const string SectionName = "PoMiniGames:Elo";

    /// <summary>AI virtual ELO rating for Easy difficulty. Default: 800.</summary>
    public int EasyAiElo { get; set; } = 800;

    /// <summary>AI virtual ELO rating for Medium difficulty. Default: 1200.</summary>
    public int MediumAiElo { get; set; } = 1200;

    /// <summary>AI virtual ELO rating for Hard difficulty. Default: 1600.</summary>
    public int HardAiElo { get; set; } = 1600;

    /// <summary>Baseline player reference ELO (fixed — not adjusted per player). Default: 1000.</summary>
    public int PlayerReferenceElo { get; set; } = 1000;

    /// <summary>K-factor for ELO adjustment. Default: 32.</summary>
    public int K { get; set; } = 32;

    // Head-to-head fighter ratings for the PoBrawl demo board are configured by
    // PairwiseEloOptions, not from here. The two systems must stay separable — see
    // PairwiseEloCalculator's remarks.
}
