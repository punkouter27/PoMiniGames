namespace PoMiniGamesClient.Features.Shared;

/// <summary>One choice in the start card's map dropdown (<see cref="GameIntro.Maps"/>).</summary>
/// <param name="Id">What the game binds and hands its engine.</param>
/// <param name="Name">What the player reads in the list.</param>
public sealed record IntroMap(string Id, string Name);
