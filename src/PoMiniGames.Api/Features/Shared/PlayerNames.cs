using PoMiniGames.Domain.Services;

namespace PoMiniGames.Features.Shared;

/// <summary>
/// The one display-name rule for every lobby and match seat: trimmed, capped at
/// <see cref="DisplayNameSanitizer.MaxLength"/>, moderated, and "Player" when blank.
/// Race services compare client-supplied names against seats through it too, so a long
/// name matches its own truncated seat.
/// </summary>
/// <remarks>
/// This deliberately delegates to <see cref="DisplayNameSanitizer"/> rather than trimming
/// on its own. A seat name is rendered to every other player in the room, which makes it
/// at least as public as a leaderboard row — so it has to go through the same
/// normalise-then-match pass the boards use. A trim-only rule here let a zero-width-padded
/// or slur-bearing name reach every opponent in a lobby while the identical name was
/// filtered out of the score board it was attached to.
/// </remarks>
public static class PlayerNames
{
    /// <summary>Shown when a submission is blank or must be rejected outright.</summary>
    public const string Fallback = "Player";

    public static string Sanitize(string raw) =>
        DisplayNameSanitizer.Sanitize(raw, Fallback).Value;
}
