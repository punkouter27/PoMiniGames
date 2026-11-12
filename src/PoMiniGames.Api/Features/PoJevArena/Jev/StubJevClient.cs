namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>
/// Deterministic stand-in for the test hosts. It is only ever registered when
/// <see cref="JevOptions.UseStub"/> is set AND the environment is <c>Test</c> — PoJevArena has no
/// decision fallback anywhere else, by design. It always picks the first offered option (for
/// <c>tactical_action</c> that is <c>melee_charge</c>, so stubbed matches actually finish), with a
/// calm panic reading.
/// </summary>
public sealed class StubJevClient : IJevClient
{
    public bool IsConfigured => true;

    public Task<JevOutcome> EvaluateAsync(JevPrompt prompt, string sessionId, string user, CancellationToken ct = default)
    {
        var (action, actionProbabilities) = FirstOf(prompt, JevPromptBuilder.ActionKey)!.Value;
        var focus = FirstOf(prompt, JevPromptBuilder.FocusKey);

        var answers = new JevAnswers(
            action, 0.6, actionProbabilities,
            focus?.Choice, focus is null ? 0 : 0.6, focus?.Probabilities,
            Panic: 0.1);
        return Task.FromResult(new JevOutcome(true, null, answers, LatencyMs: 0));
    }

    private static (string Choice, Dictionary<string, double> Probabilities)? FirstOf(JevPrompt prompt, string key)
    {
        if (!prompt.Questions.TryGetValue(key, out var question) || question.Criteria.Count == 0) return null;

        var options = question.Criteria.Keys.ToList();
        var rest = options.Count > 1 ? 0.4 / (options.Count - 1) : 0;
        var probabilities = options.ToDictionary(o => o, o => o == options[0] ? (options.Count > 1 ? 0.6 : 1.0) : rest);
        return (options[0], probabilities);
    }
}
