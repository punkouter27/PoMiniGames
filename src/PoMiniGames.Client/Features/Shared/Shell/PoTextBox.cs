using Radzen.Blazor;

namespace PoMiniGamesClient.Features.Shared;

/// <summary>
/// The app's text box: a <see cref="RadzenTextBox"/> (Value/ValueChanged, Immediate, MaxLength, Placeholder) that
/// carries only the app's own classes plus <c>po-rz-plain</c> instead of Radzen's theme classes, so each game's own
/// input styling draws it exactly as it drew the native <c>&lt;input&gt;</c> (Profile A: Radzen controls, the app's look).
/// </summary>
public sealed class PoTextBox : RadzenTextBox
{
    /// <inheritdoc />
    protected override string GetComponentCssClass() => Disabled ? "po-rz-plain rz-state-disabled" : "po-rz-plain";
}
