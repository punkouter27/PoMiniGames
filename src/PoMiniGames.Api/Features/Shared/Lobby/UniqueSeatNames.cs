namespace PoMiniGames.Features.Shared.Lobby;

/// <summary>
/// Two players can carry the same initials (or both skipped the prompt). A quiz keys its scores
/// by name, so the lobby gives the second one a numeric suffix and the match is joined by it.
/// </summary>
public static class UniqueSeatNames
{
    public static string Make(string requested, IEnumerable<string> taken)
    {
        var set = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        if (!set.Contains(requested)) return requested;
        for (var i = 2; ; i++)
        {
            var candidate = $"{requested} ({i})";
            if (!set.Contains(candidate)) return candidate;
        }
    }
}
