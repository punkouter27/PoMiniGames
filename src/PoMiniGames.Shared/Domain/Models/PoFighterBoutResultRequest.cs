namespace PoMiniGames.Domain.Models;

/// <summary>
/// One finished CPU-vs-CPU PoFighter tournament bout. On a draw the winner/loser split is
/// arbitrary and <see cref="IsDraw"/> decides the scoring. Carries who fought and who won and
/// nothing else: ratings are resolved server-side.
/// </summary>
public sealed record PoFighterBoutResultRequest(string WinnerFighterId, string LoserFighterId, bool IsDraw);
