namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Tunables for PoCoupleQuiz, from <c>appsettings.json</c> section <c>PoCoupleQuiz</c>.
/// </summary>
/// <remarks>
/// This class used to carry six timing knobs — <c>KingAnswerTimeSeconds</c>, three
/// <c>PlayerAnswerTime*Seconds</c>, <c>MaxAnswerWords</c> and <c>PreRoundCountdownSeconds</c>
/// — none of which anything read. The hub injected the options object and never touched it,
/// so the game had no timers at all and rounds only moved when the host clicked a button.
/// The two values below are the ones <see cref="CoupleQuizRoundDirector"/> actually enforces.
/// </remarks>
public sealed class CoupleQuizOptions
{
    public const string SectionName = "PoCoupleQuiz";

    /// <summary>
    /// How long a round stays open. When it expires the round is scored with whatever has
    /// been submitted, so one idle player can no longer stall everyone else indefinitely.
    /// </summary>
    public int RoundSeconds { get; set; } = 60;

    /// <summary>How long the round result stays on screen before the next question.</summary>
    public int RevealSeconds { get; set; } = 6;
}
