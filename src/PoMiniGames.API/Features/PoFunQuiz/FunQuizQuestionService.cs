using System.Security.Cryptography;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>Where PoFunQuiz gets a quiz's questions. The endpoint and the multiplayer lobby both go through this.</summary>
public interface IFunQuizQuestionSource
{
    /// <summary>
    /// <paramref name="count"/> distinct questions for <paramref name="category"/>, dealt at random
    /// with shuffled options. Fewer come back only when the category's bank is smaller than asked.
    /// </summary>
    Task<IReadOnlyList<QuizQuestion>> GetQuestionsAsync(
        QuestionCategory category, int count, CancellationToken cancellationToken = default);
}

/// <summary>
/// Deals quizzes at random from the in-memory bank (<see cref="BundledQuizQuestions"/>, loaded once
/// from <c>Data/questions.json</c>). No storage, no network, no cost.
/// </summary>
public sealed class FunQuizQuestionService : IFunQuizQuestionSource
{
    private const int MaxCount = 50;

    public Task<IReadOnlyList<QuizQuestion>> GetQuestionsAsync(
        QuestionCategory category, int count, CancellationToken cancellationToken = default)
    {
        var pool = BundledQuizQuestions.For(category);
        return Task.FromResult(Deal(pool, Math.Clamp(count, 1, MaxCount)));
    }

    /// <summary>A random <paramref name="count"/>-sized hand from <paramref name="pool"/>, as copies with the options reshuffled.</summary>
    internal static IReadOnlyList<QuizQuestion> Deal(IReadOnlyList<QuizQuestion> pool, int count)
    {
        var take = Math.Min(count, pool.Count);
        var order = new int[pool.Count];
        for (var i = 0; i < order.Length; i++) order[i] = i;

        // Partial Fisher-Yates: only the first `take` slots are needed.
        for (var i = 0; i < take; i++)
        {
            var j = RandomNumberGenerator.GetInt32(i, order.Length);
            (order[i], order[j]) = (order[j], order[i]);
        }

        var hand = new List<QuizQuestion>(take);
        for (var i = 0; i < take; i++) hand.Add(WithShuffledOptions(pool[order[i]]));
        return hand;
    }

    private static QuizQuestion WithShuffledOptions(QuizQuestion source)
    {
        var options = source.Options.ToArray();
        var correct = options[source.CorrectOptionIndex];
        RandomNumberGenerator.Shuffle(options.AsSpan());
        return new QuizQuestion
        {
            Text = source.Text,
            Options = [.. options],
            CorrectOptionIndex = Array.IndexOf(options, correct),
            Category = source.Category,
            Difficulty = source.Difficulty,
        };
    }
}
