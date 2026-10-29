using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// What the end of a game looks, sounds and feels like, decided once for every game.
/// GameOverModal plays it the moment it opens; no game fires its own.
/// </summary>
/// <remarks>
/// Pure data, so the choice is testable without a browser. The gates for reduced motion
/// and the quality tier stay in the JS modules that draw the effects (gpuFx, impactBus,
/// paletteBus), the same as for every other caller of <see cref="ScreenFxService"/>.
/// </remarks>
/// <param name="Cues">Outcome cue names to try in order, in the game's own scope.</param>
/// <param name="SharedScope">True when the cue must come from the shared "ui" scope (an
/// unreported result has no game-specific voice worth guessing at).</param>
/// <param name="Haptic">Vibration to go with the cue.</param>
/// <param name="PaletteMood">Palette pulse mood, or null for none (paletteBus has no
/// neutral mood, so a draw does not pulse).</param>
/// <param name="Confetti">Rain confetti over the modal.</param>
/// <param name="Vignette">Grey the page behind the modal (a loss).</param>
/// <param name="HitstopMs">How long the game behind the modal freezes, in ms.</param>
public sealed record GameOverMoment(
    string[] Cues,
    bool SharedScope,
    int[] Haptic,
    string? PaletteMood,
    bool Confetti,
    bool Vignette,
    int HitstopMs)
{
    /// <summary>
    /// Outcome cue names, in the order to try them. Games name winning differently —
    /// "win" in TicTacToe/ConnectFive, "ko" in Brawl, "finish" in Marble Race, "goal" in
    /// Sports — so the modal asks for the family and takes whichever this game defines.
    /// The final entry in each list is the shared "ui" fallback, which every scope resolves.
    /// </summary>
    private static readonly string[] WinCues = ["win", "ko", "finish", "goal", "correct", "victory", "confirm"];
    private static readonly string[] LossCues = ["death", "bust", "crash", "wrong", "timeout", "defeat", "error"];
    private static readonly string[] DrawCues = ["draw", "whistle", "reveal", "confirm"];

    /// <summary>
    /// The moment for a result. A new personal best earns confetti whatever the result
    /// (a best lap in a lost race is still a best); a loss is never celebrated otherwise.
    /// </summary>
    public static GameOverMoment For(GameResult outcome, bool newBest) => outcome switch
    {
        GameResult.Win => new(WinCues, false, [20, 60, 20, 60, 40], ScreenFxService.Win, true, false, 70),
        GameResult.Loss => new(LossCues, false, [90], ScreenFxService.Lose, newBest, !newBest, 90),
        GameResult.Draw => new(DrawCues, false, [12, 28, 12], null, newBest, false, 0),
        _ => new(["confirm"], true, [12, 28, 12], newBest ? ScreenFxService.Win : null, newBest, false, 0),
    };
}
