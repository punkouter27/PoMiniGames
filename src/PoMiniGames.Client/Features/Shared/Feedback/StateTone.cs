namespace PoMiniGamesClient.Features.Shared;

/// <summary>
/// Which of the two things a <c>StatePanel</c>-shaped card is reporting. The tone
/// decides the tint, the ARIA role (<c>status</c> vs <c>alert</c>) and whether a
/// screen reader is interrupted — nothing else.
/// </summary>
public enum StateTone
{
    /// <summary>"Nothing here yet." Muted card, announced politely.</summary>
    Info,

    /// <summary>"That failed." Danger tint, announced immediately.</summary>
    Error,
}
