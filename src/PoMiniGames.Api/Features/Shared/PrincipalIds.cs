namespace PoMiniGames.Features.Shared;

/// <summary>
/// The one principal-id rule for every lobby and match seat.
/// </summary>
public static class PrincipalIds
{
    /// <summary>
    /// Lower-cased and trimmed because the value doubles as a Table Storage row key, and
    /// Azure table row keys are case-sensitive. The result ingest keys the Elo rows through
    /// this too, so a seat and its rating row always agree. "anon" when blank.
    /// </summary>
    public static string Sanitize(string raw) =>
        string.IsNullOrWhiteSpace(raw) ? "anon" : raw.Trim().ToLowerInvariant();
}
