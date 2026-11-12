namespace PoMiniGames.Features.Integrity;

/// <summary>How hard the play-session tier of the score guard pushes back.</summary>
public enum IntegrityMode
{
    /// <summary>Sessions are neither minted nor checked. The absolute-range tier still applies.</summary>
    Off,

    /// <summary>Check and log, but always save. The default — see <see cref="IntegrityOptions"/>.</summary>
    Observe,

    /// <summary>Reject a submission whose session is missing, stale, mismatched or implausible.</summary>
    Enforce,
}

/// <summary>
/// Configuration for score-submission integrity (<c>PoMiniGames:Integrity</c>).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the default is Observe and not Enforce.</b> Two live paths submit scores without a
/// fresh play session and are both legitimate: <c>ScoreSyncService</c> replays scores parked in
/// the offline queue — possibly hours later, possibly across a sign-in — and any game that ends
/// a round after the session TTL has run out. Shipping straight to Enforce would silently drop
/// exactly the scores the PWA's durable-submission design exists to protect. Observe puts the
/// verdicts in the logs at Warning first; flip to Enforce once those logs are quiet.
/// </para>
/// <para>
/// The absolute-range tier (<see cref="PoMiniGames.Domain.Services.ScoreRules.CheckValue"/>) is
/// deliberately NOT governed by <see cref="Mode"/>. It needs nothing from the client, cannot
/// produce a false reject on a real run, and is what keeps <c>int.MaxValue</c> off the board —
/// so it is on from the first request, in every environment.
/// </para>
/// </remarks>
public sealed class IntegrityOptions
{
    public const string SectionName = "PoMiniGames:Integrity";

    /// <summary>Governs the play-session tier only. Default <see cref="IntegrityMode.Observe"/>.</summary>
    public IntegrityMode Mode { get; set; } = IntegrityMode.Observe;

    /// <summary>
    /// How long a minted session stays redeemable. A session is minted when the player opens a
    /// game, so this is "how long a single sitting may last", not how long a round takes.
    /// </summary>
    public int SessionTtlMinutes { get; set; } = 120;

    /// <summary>
    /// Ceiling on the elapsed time a single session may vouch for, regardless of its real age.
    /// </summary>
    /// <remarks>
    /// Without this, the rate tier has an obvious hole: mint a session, wait, and the accrued
    /// wall-clock alone justifies an enormous point total. Capping credited elapsed at 15
    /// minutes means a stale token buys no more headroom than a long honest round would.
    /// </remarks>
    public int MaxCreditedSeconds { get; set; } = 900;

    /// <summary>
    /// Enforce the absolute-range tier. On by default and should stay on; exposed so a board
    /// whose bounds turn out to be wrong can be opened up without a deploy.
    /// </summary>
    public bool EnforceValueBounds { get; set; } = true;

    /// <summary>
    /// Run player-supplied display names through
    /// <see cref="PoMiniGames.Domain.Services.DisplayNameSanitizer"/> before they reach a public
    /// board. On by default; a rejected name falls back to the server-derived identity rather
    /// than failing the submission.
    /// </summary>
    public bool ModerateDisplayNames { get; set; } = true;

    /// <summary>Resolved TTL as a <see cref="TimeSpan"/>, floored at one minute.</summary>
    public TimeSpan SessionTtl => TimeSpan.FromMinutes(Math.Max(1, SessionTtlMinutes));

    /// <summary>Resolved elapsed ceiling, floored at ten seconds.</summary>
    public TimeSpan MaxCredited => TimeSpan.FromSeconds(Math.Max(10, MaxCreditedSeconds));
}
