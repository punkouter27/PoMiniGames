using System.Reflection;
using System.Text.Json;
using PoMiniGames.Serialization;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// The PoCoupleQuiz question bank: questions about the couple's own life together — how they met,
/// dates and trips, home life, celebrations, adventures and inside jokes — in six topics, shipped
/// as the embedded <c>Data/questions.json</c> and loaded once on first use. It is not a trivia
/// game: every answer is something only the two of them know.
/// </summary>
/// <remarks>
/// Written for the game's actual shape — one player (the King) types an answer and the others
/// try to match it — so every question has a short answer both partners could give, avoids
/// "who" questions (the King's "me" is the partner's "you", so they could never match), stays
/// short, and is fine for a family game night.
/// </remarks>
public static class CoupleQuizQuestionBank
{
    private const string ResourceName = "PoCoupleQuiz.questions.json";

    /// <summary>The lobby's "all topics" choice, and the default.</summary>
    public const string Everything = "Everything";

    /// <summary>Every topic the lobby can pick: <see cref="Everything"/>, then each category.</summary>
    public static readonly IReadOnlyList<string> Topics =
        [Everything, .. Enum.GetNames<QuestionCategory>()];

    private static readonly Lazy<IReadOnlyList<Question>> Loaded = new(Load);

    /// <summary>Every question in the bank, all topics.</summary>
    public static IReadOnlyList<Question> All => Loaded.Value;

    public static bool IsValidTopic(string? topic) =>
        !string.IsNullOrWhiteSpace(topic) && Topics.Contains(topic, StringComparer.OrdinalIgnoreCase);

    /// <summary>The canonical spelling of <paramref name="topic"/>, or <see cref="Everything"/>.</summary>
    public static string NormalizeTopic(string? topic) =>
        Topics.FirstOrDefault(t => string.Equals(t, topic, StringComparison.OrdinalIgnoreCase)) ?? Everything;

    /// <summary>
    /// A random question from <paramref name="topic"/> (all topics for <see cref="Everything"/> or
    /// an unknown topic) that none of <paramref name="asked"/> has used. When the topic has been
    /// asked out (a very long session) the exclusion is ignored rather than running dry.
    /// </summary>
    public static Question Draw(IReadOnlySet<string> asked, string? topic = null, Random? random = null)
    {
        random ??= Random.Shared;
        IEnumerable<Question> pool = All;
        if (Enum.TryParse<QuestionCategory>(NormalizeTopic(topic), out var category))
        {
            pool = pool.Where(q => q.Category == category);
        }

        var inTopic = pool.ToList();
        var fresh = inTopic.Where(q => !asked.Contains(q.Text)).ToList();
        var pickFrom = fresh.Count > 0 ? fresh : inTopic;
        var picked = pickFrom[random.Next(pickFrom.Count)];
        return new Question { Text = picked.Text, Category = picked.Category };
    }

    private static IReadOnlyList<Question> Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{ResourceName}' is missing.");
        var byCategory = JsonSerializer.Deserialize(stream, ApiJsonContext.Default.QuestionBank)
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
