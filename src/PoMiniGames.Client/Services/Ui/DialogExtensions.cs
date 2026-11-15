using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// Option #9: tiny interop helpers for the native <c>&lt;dialog&gt;</c> element.
///
/// <see cref="ElementReferenceExtensions"/> is built into Blazor and already
/// exposes <c>FocusAsync</c>, but the native dialog API has two extra surface
/// methods (<c>showModal</c> and <c>close</c>) that need a JS shim — calling
/// them via the .NET binding would need a separate IJSRuntime call per usage
/// site, so a single helper is the cheaper option. Both helpers are safe to
/// call on a non-dialog ElementReference; the JS guard rejects it with a
/// silent no-op rather than throwing into the render loop.
/// </summary>
public static class DialogExtensions
{
    /// <summary>
    /// Calls <c>dialog.showModal()</c> on the referenced element. Places the
    /// dialog in the top layer, applies a focus trap, and exposes the
    /// <c>:backdrop</c> pseudo-element so a single CSS rule can paint the dim
    /// layer. No-op if the element is not a <c>&lt;dialog&gt;</c> or is already
    /// open.
    /// </summary>
    public static ValueTask ShowModalAsync(this ElementReference dialog, IJSRuntime js)
        => js.InvokeVoidAsync("PoDialogInterop.showModal", dialog);

    /// <summary>
    /// <see cref="ShowModalAsync"/> for a sheet that can be opened from inside another
    /// modal layer (a game's pause dialog or dashboard). Those layers are put away while
    /// it is up, so only one backdrop shows, and come back when it closes.
    /// </summary>
    public static ValueTask ShowModalAloneAsync(this ElementReference dialog, IJSRuntime js)
        => js.InvokeVoidAsync("PoDialogInterop.showModalAlone", dialog);

    /// <summary>
    /// Calls <c>dialog.close()</c>. The dialog fires its native <c>close</c>
    /// event and is removed from the top layer. Call this before any Blazor
    /// navigation that fires from inside the modal — otherwise the modal stays
    /// in the top layer for the duration of the page transition, which reads
    /// as a frozen UI on the destination route.
    /// </summary>
    public static ValueTask CloseAsync(this ElementReference dialog, IJSRuntime js)
        => js.InvokeVoidAsync("PoDialogInterop.close", dialog);
}
