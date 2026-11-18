namespace PoMiniGamesClient.Features.Shared;

/// <summary>What <see cref="OnlineLobby{TPlayer}"/> hands a page when the host starts.</summary>
/// <param name="MatchCode">The internal match code: plumbing for the game hub, never shown.</param>
/// <param name="WasHost">True in the browser that hosted the lobby (it hosts the match too).</param>
public sealed record OnlineLobbyStart(string MatchCode, bool WasHost);
