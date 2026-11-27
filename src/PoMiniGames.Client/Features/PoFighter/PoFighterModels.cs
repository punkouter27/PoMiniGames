namespace PoMiniGamesClient.Features.PoFighter;

/// <summary>
/// A fighter made in the in-browser Studio (studio.js, IndexedDB): its id, name and a small
/// portrait data URL ('' when none could be cut).
/// </summary>
public sealed record PoFighterCustom(string Id, string Name, string Portrait);

/// <summary>
/// One corner of the select screen (PoFighterSelect): the name on the plate, the flag beside it
/// ("1P", "CPU", "Seed 2"), the large art ('' or null draws <paramref name="Icon"/> instead) and a
/// short note under the name (the Elo).
/// </summary>
public sealed record PoFighterSide(string Name, string Tag, string? Art, string? Note, string Icon = "person");

/// <summary>What the dossier shows about a fighter, built-in or Studio.</summary>
public sealed record PoFighterCard(string Id, string Name, string Portrait, bool IsCustom);
