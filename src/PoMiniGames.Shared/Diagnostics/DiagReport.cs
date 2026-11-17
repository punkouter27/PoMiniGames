namespace PoMiniGames.Shared.Diagnostics;

/// <summary>
/// The <c>GET /api/diag</c> payload, rendered by the client's /diag page. Built from the
/// server's registered health checks plus a configured/not-configured note for each external
/// service. It is anonymous, so it carries no secrets or identifying internals: no connection
/// strings, keys, vault or storage URIs, file paths, ids, emails, stack traces or exception
/// messages — at most an exception TYPE name in <see cref="DiagCheck.Error"/>.
/// </summary>
/// <param name="Status">Worst status of every check: Healthy, Degraded or Unhealthy.</param>
/// <param name="Version">Build date, YYMMDD.</param>
/// <param name="Environment">Hosting environment name (Development, Test, Production).</param>
public sealed record DiagReport(
    string Status,
    string Version,
    string Environment,
    DateTimeOffset CheckedAtUtc,
    double TotalMs,
    IReadOnlyList<DiagCheck> Stores,
    IReadOnlyList<DiagCheck> Services);

/// <summary>One store or service.</summary>
/// <param name="Status">Healthy, Degraded, Unhealthy, or "Not configured" for a service this environment does not use.</param>
/// <param name="Description">One plain-English line on what it is for.</param>
/// <param name="LatencyMs">How long the check took; null when nothing was probed.</param>
/// <param name="Error">Exception type name only, when the check threw.</param>
public sealed record DiagCheck(
    string Name,
    string Status,
    string Description,
    double? LatencyMs,
    string? Error);
