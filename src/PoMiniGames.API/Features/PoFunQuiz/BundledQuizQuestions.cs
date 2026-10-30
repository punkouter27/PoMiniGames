using System.Text.Json;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// The question bank shipped inside the API assembly (<c>Data/questions.json</c>, an embedded
/// resource), loaded once on first use. Every Fun Quiz deal comes from here: no storage, no network.
/// </summary>
/// <remarks>
/// Gathered ahead of time from Open Trivia DB plus the original hand-written set (the DB's content
/// is CC BY-SA 4.0). Items pass the same <see cref="QuizQuality"/> gate as ever; one that does not is
/// dropped at load rather than served, and the unit tier checks the file ships none.
/// </remarks>
public static class BundledQuizQuestions
{
    /// <summary>Logical name set in the csproj, independent of the folder layout.</summary>
    internal const string ResourceName = "PoFunQuiz.questions.json";

    private static readonly Lazy<IReadOnlyDictionary<QuestionCategory, IReadOnlyList<QuizQuestion>>> Bank = new(Load);

    /// <summary>The bundled questions for one category (empty for an unknown one).</summary>
    public static IReadOnlyList<QuizQuestion> For(QuestionCategory category) =>
        Bank.Value.TryGetValue(category, out var list) ? list : [];

    /// <summary>Every bundled question, all categories.</summary>
    public static IEnumerable<QuizQuestion> All => Bank.Value.Values.SelectMany(l => l);

    private static IReadOnlyDictionary<QuestionCategory, IReadOnlyList<QuizQuestion>> Load()
    {
        var byCategory = new Dictionary<QuestionCategory, List<QuizQuestion>>();
        using var stream = typeof(BundledQuizQuestions).Assembly.GetManifestResourceStream(ResourceName);
        if (stream is null) return new Dictionary<QuestionCategory, IReadOnlyList<QuizQuestion>>();

        using var doc = JsonDocument.Parse(stream);
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (!Enum.TryParse<QuestionCategory>(item.GetProperty("c").GetString(), out var category)) continue;
            var text = item.GetProperty("q").GetString() ?? string.Empty;
            var answer = item.GetProperty("a").GetString() ?? string.Empty;
            var options = item.GetProperty("w").EnumerateArray().Select(w => w.GetString() ?? string.Empty).ToList();
            options.Insert(0, answer);
            if (QuizQuality.Reject(text, options, 0) is not null) continue;

            var difficulty = Enum.TryParse<DifficultyLevel>(item.GetProperty("d").GetString(), out var d)
                ? d
                : DifficultyLevel.Medium;

            if (!byCategory.TryGetValue(category, out var list)) byCategory[category] = list = [];
            // Stored with the answer first; every deal reshuffles the options (SelectVariedSet).
            list.Add(new QuizQuestion
            {
                Text = text,
                Options = options,
                CorrectOptionIndex = 0,
                Category = category,
                Difficulty = difficulty,
            });
        }

        return byCategory.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<QuizQuestion>)kv.Value);
    }
}
