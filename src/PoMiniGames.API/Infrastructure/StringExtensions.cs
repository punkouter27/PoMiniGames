namespace PoMiniGames.Infrastructure;

/// <summary>Small string helpers shared by the storage paths.</summary>
internal static class StringExtensions
{
    /// <summary>
    /// The first <paramref name="max"/> characters, cut hard with no ellipsis (storage column
    /// caps). For a log-line excerpt use a plain substring instead.
    /// </summary>
    public static string Truncate(this string value, int max)
        => value.Length <= max ? value : value[..max];
}
