using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>Configuration for optional OpenTriviaDB live trivia enrichment.</summary>
public sealed class OpenTriviaOptions
{
    public const string SectionName = "PoMiniGames:PoFunQuiz:OpenTrivia";

    /// <summary>Disabled in hermetic test hosts; falls back to BundledQuizQuestions when off or unreachable.</summary>
    public bool Enabled { get; set; } = true;
}

/// <summary>
/// Fetches and caches free trivia batches from OpenTriviaDB (30-minute TTL per category) to enrich
/// <see cref="FunQuizQuestionService"/>. Failures degrade silently to the bundled JSON bank.
/// </summary>
public sealed class OpenTriviaService(
    IHttpClientFactory httpFactory,
    IOptionsMonitor<OpenTriviaOptions> options,
    TimeProvider timeProvider)
{
    public const string HttpClientName = "PoFunQuiz.OpenTrivia";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);
    private readonly ConcurrentDictionary<QuestionCategory, (DateTimeOffset At, IReadOnlyList<QuizQuestion> Items)> _cache = new();

    public async Task<IReadOnlyList<QuizQuestion>> GetCachedQuestionsAsync(QuestionCategory category, CancellationToken ct)
    {
        if (!options.CurrentValue.Enabled)
            return [];

        var now = timeProvider.GetUtcNow();
        if (_cache.TryGetValue(category, out var hit) && now - hit.At < CacheTtl)
            return hit.Items;

        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            var url = MapCategoryId(category) is { } catId
                ? $"api.php?amount=20&type=multiple&category={catId}"
                : "api.php?amount=20&type=multiple";

            using var resp = await client.GetAsync(url, ct);
            if (!resp.IsSuccessStatusCode)
                return [];

            using var doc = await JsonDocument.ParseAsync(await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                return [];

            var list = new List<QuizQuestion>();
            foreach (var item in results.EnumerateArray())
            {
                var qText = WebUtility.HtmlDecode(item.GetProperty("question").GetString() ?? "").Trim();
                var correct = WebUtility.HtmlDecode(item.GetProperty("correct_answer").GetString() ?? "").Trim();
                if (string.IsNullOrEmpty(qText) || string.IsNullOrEmpty(correct)) continue;

                var opts = new List<string> { correct };
                if (item.TryGetProperty("incorrect_answers", out var wrongs) && wrongs.ValueKind == JsonValueKind.Array)
                {
                    foreach (var w in wrongs.EnumerateArray())
                    {
                        var decoded = WebUtility.HtmlDecode(w.GetString() ?? "").Trim();
                        if (!string.IsNullOrEmpty(decoded)) opts.Add(decoded);
                    }
                }
                if (opts.Count != 4) continue;

                var diff = (item.TryGetProperty("difficulty", out var d) ? d.GetString() : null) switch
                {
                    "easy" => DifficultyLevel.Easy,
                    "hard" => DifficultyLevel.Hard,
                    _ => DifficultyLevel.Medium,
                };

                list.Add(new QuizQuestion
                {
                    Text = qText,
                    Options = opts,
                    CorrectOptionIndex = 0,
                    Category = category,
                    Difficulty = diff,
                });
            }

            if (list.Count > 0)
                _cache[category] = (now, list);
            return list;
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            return [];
        }
    }

    private static int? MapCategoryId(QuestionCategory category) => category switch
    {
        QuestionCategory.Science => 17,
        QuestionCategory.History => 23,
        QuestionCategory.Geography => 22,
        QuestionCategory.Sports => 21,
        QuestionCategory.Entertainment => 11,
        _ => null,
    };
}
