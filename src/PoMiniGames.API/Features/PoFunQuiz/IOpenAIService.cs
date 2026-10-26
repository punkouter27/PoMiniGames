namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Generates trivia questions for PoFunQuiz. The "engine" is a UI choice:
/// <c>AzureOpenAI</c> (server-side, gpt-5-nano on the shared
/// po-aiservices-shared2 account) or <c>BrowserAI</c> (client-side WebLLM).
/// </summary>
public interface IOpenAIService
{
    /// <summary>Generate <paramref name="count"/> questions for the given category.</summary>
    Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(
        QuestionCategory category,
        int count,
        CancellationToken cancellationToken = default);
}
