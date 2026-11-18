namespace PoMiniGamesClient.Models;

/// <summary>
/// A signed play session as returned by <c>POST /api/play/sessions/{game}</c>.
/// </summary>
/// <remarks>
/// The token is opaque: it is Data Protection ciphertext the server issued to itself, and the
/// client's only job is to hand it back on the score submission. Nothing here should ever be
/// parsed or trusted client-side — <c>ExpiresAtUtc</c> is used solely to avoid sending a token
/// the server is certain to reject.
/// </remarks>
public sealed record PlaySessionTicketDto(string Token, DateTimeOffset IssuedAtUtc, DateTimeOffset ExpiresAtUtc);

/// <summary>Result of <c>DELETE /api/account/data</c> — what was actually erased, per table.</summary>
public sealed record AccountDeletionDto(DateTimeOffset DeletedAtUtc, int TotalRows, Dictionary<string, int> Tables);
