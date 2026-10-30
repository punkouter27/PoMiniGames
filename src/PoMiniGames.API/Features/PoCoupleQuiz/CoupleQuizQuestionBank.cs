using System.Reflection;
using System.Text.Json;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// The curated PoCoupleQuiz question bank: about a thousand short questions across six
/// categories, shipped as the embedded <c>Data/questions.json</c> and loaded once on first use.
/// The round director deals from here at random.
/// </summary>
/// <remarks>
/// Written for the game's actual shape — one player (the King) answers about themselves and the
/// others guess that answer — so every question has a short answer the King knows, stays under
/// thirteen words, and is fine for a family game night.
/// </remarks>
public static class CoupleQuizQuestionBank
{
    private const string ResourceName = "PoCoupleQuiz.questions.json";

    private static readonly Lazy<IReadOnlyList<Question>> Loaded = new(Load);

    /// <summary>Every question in the bank, all categories.</summary>
    public static IReadOnlyList<Question> All => Loaded.Value;

    /// <summary>
    /// A random question none of <paramref name="asked"/> has used. When every question has been
    /// asked (a very long session) the exclusion is ignored rather than running dry.
    /// </summary>
    public static Question Draw(IReadOnlySet<string> asked, Random? random = null)
    {
        random ??= Random.Shared;
        var all = All;
        var fresh = all.Where(q => !asked.Contains(q.Text)).ToList();
        var pickFrom = fresh.Count > 0 ? fresh : all;
        var picked = pickFrom[random.Next(pickFrom.Count)];
        return new Question { Text = picked.Text, Category = picked.Category };
    }

    private static IReadOnlyList<Question> Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{ResourceName}' is missing.");
        var byCategory = JsonSerializer.Deserialize<Dictionary<string, string[]>>(stream)
            ?? throw new InvalidOperationException("The couple question bank is empty.");

        var list = new List<Question>();
        foreach (var (name, texts) in byCategory)
        {
            var category = Enum.Parse<QuestionCategory>(name);
            list.AddRange(texts.Select(text => new Question { Text = text, Category = category }));
        }

        return list;
    }
}
