namespace PoMiniGamesClient.Features.PoFighter;

/// <summary>
/// A fighter made in the in-browser Studio (studio.js, IndexedDB): its id, name and a small
/// portrait data URL ('' when none could be cut).
/// </summary>
public sealed record PoFighterCustom(string Id, string Name, string Portrait);

/// <summary>What the dossier shows about a fighter, built-in or Studio.</summary>
public sealed record PoFighterCard(string Id, string Name, string Portrait, bool IsCustom);
