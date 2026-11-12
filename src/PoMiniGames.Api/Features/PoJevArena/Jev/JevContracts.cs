namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>One unit's validated answers.</summary>
public sealed record JevAnswers(
    string Action,
    double ActionConfidence,
    Dictionary<string, double> ActionProbabilities,
    string? Focus,
    double FocusConfidence,
    Dictionary<string, double>? FocusProbabilities,
    double Panic);

/// <summary>
/// One evaluation: answers on success, or a stable failure code (for example <c>unknown-option</c>
/// or <c>bad-probability</c>). A failure means the unit holds its last intent.
/// </summary>
public sealed record JevOutcome(bool Ok, string? Failure, JevAnswers? Answers, int LatencyMs)
{
    public static JevOutcome Fail(string failure, int latencyMs = 0) => new(false, failure, null, latencyMs);
}

/// <summary>The decision boundary. One call evaluates one unit's three questions.</summary>
public interface IJevClient
{
    bool IsConfigured { get; }

    Task<JevOutcome> EvaluateAsync(JevPrompt prompt, string sessionId, string user, CancellationToken ct = default);
}
