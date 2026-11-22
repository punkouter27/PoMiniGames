using Radzen.Blazor;

namespace PoMiniGamesClient.Features.Shared;

/// <summary>
/// The app's action button: a <see cref="RadzenButton"/> (Click, Disabled, ButtonType, busy state and Radzen's
/// keyboard handling) that carries only the app's own classes (<c>app-btn</c>, <c>po-link-btn</c>) instead of
/// Radzen's theme classes.
/// </summary>
/// <remarks>
/// Radzen's theme stylesheet is loaded only while a Radzen-heavy page is open (js/platform/radzenTheme.js), and its
/// <c>.rz-button.rz-variant-*</c> rules would restyle the shell's buttons on exactly those pages (uppercase, new
/// padding, no fill). Dropping the <c>rz-button</c> classes keeps the shell looking the same on every page;
/// <c>.po-rz-plain &gt; .rz-button-box</c> in app.css lets the button's children lay out as before.
/// </remarks>
public sealed class PoButton : RadzenButton
{
    /// <inheritdoc />
    protected override string GetComponentCssClass() => IsDisabled ? "po-rz-plain rz-state-disabled" : "po-rz-plain";
}
