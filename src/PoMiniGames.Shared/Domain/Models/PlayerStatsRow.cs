namespace PoMiniGames.Domain.Models;

/// <summary>
/// One player's stats for one game, as stored and as returned over the wire by
/// <c>GET /api/{game}/players/{name}/stats</c>.
/// </summary>
/// <remarks>
/// Named "Row" rather than "Dto" on purpose: the WASM client has its own
/// <c>PlayerStatsDto</c> (a different <c>PlayerStats</c> shape, because the client
/// model carries per-tier local data the server does not store). Two types with the
/// same name in two assemblies is the kind of collision that makes a compiler error
/// the only way to learn which one you are holding.
/// </remarks>
public sealed class PlayerStatsRow
{
    public required string Name { get; init; }
    public required string Game { get; init; }
    public required PlayerStats Stats { get; init; }
}
