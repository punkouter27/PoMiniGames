namespace PoMiniGames.Infrastructure;

/// <summary>Small string helpers shared across storage and endpoint sanitization paths.</summary>
internal static class StringExtensions
{
    /// <summary>
    /// The first <paramref name="max"/> characters, cut hard with no ellipsis (storage column
    /// caps). For a log-line excerpt use a plain substring instead.
    /// </summary>
    public static string Truncate(this string value, int max)
        => value.Length <= max ? value : value[..max];

    /// <summary>
    /// Strips ASCII/Unicode control characters (replacing with spaces when <paramref name="flattenToSpace"/>
    /// is true, or omitting them), trims whitespace, and caps length.
    /// </summary>
    public static string StripControlChars(this string? value, int maxLength = int.MaxValue, bool flattenToSpace = false)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var bounded = value.Length <= maxLength ? value : value[..maxLength];
        if (flattenToSpace)
        {
            return string.Create(bounded.Length, bounded, static (span, source) =>
            {
                for (var i = 0; i < source.Length; i++)
                    span[i] = char.IsControl(source[i]) ? ' ' : source[i];
            }).Trim();
        }
        return new string(bounded.Where(ch => !char.IsControl(ch)).ToArray()).Trim();
    }
}
