namespace PoMiniGamesClient.Features.PoFunQuiz;

/// <summary>
/// The Fun Quiz categories a player can pick, for every picker (the solo and split-screen
/// start card, the online lobby). <c>Value</c> is the wire name: the server's
/// <c>QuestionCategory</c> enum member.
/// </summary>
public static class FunQuizCategories
{
    /// <summary>Where the last pick is kept, shared by every mode.</summary>
    public const string StorageKey = "pominigames:funquiz-category";

    public const string Default = "General";

    public static readonly IReadOnlyList<(string Value, string Label)> All =
    [
        ("General", "General"),
        ("Science", "Science"),
        ("History", "History"),
        ("Geography", "Geography"),
        ("Sports", "Sports"),
        ("Entertainment", "Entertainment"),
        ("Technology", "Technology"),
        ("ArtCulture", "Art & Culture"),
    ];

    /// <summary>The picker's spelling of a wire value ("ArtCulture" reads "Art &amp; Culture").</summary>
    public static string LabelFor(string? value)
    {
        foreach (var c in All)
        {
            if (c.Value == value) return c.Label;
        }
        return string.IsNullOrEmpty(value) ? Default : value;
    }
}
