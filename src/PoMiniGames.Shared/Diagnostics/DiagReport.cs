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
    IReadOnlyList<DiagCheck> Services,
    IReadOnlyList<DiagResource> Tables,
    IReadOnlyList<DiagResource> Containers,
    IReadOnlyList<DiagHub> Hubs);

/// <summary>One Azure Table or Blob container the app uses. Name only: never the account address.</summary>
/// <param name="Name">Table or container name.</param>
/// <param name="Reachable">True when the storage service answered the listing.</param>
/// <param name="Exists">True when the listing included it. Reachable but not existing is normal
/// for a store created on first use (the PoEcosystem world container).</param>
public sealed record DiagResource(string Name, bool Reachable, bool Exists);

/// <summary>One mapped SignalR hub.</summary>
/// <param name="Name">Hub class name.</param>
/// <param name="Route">The mapped route, for example /connectfive/hub.</param>
/// <param name="Connections">Live connection count, or null when the hub does not track one.</param>
public sealed record DiagHub(string Name, string Route, int? Connections);

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
