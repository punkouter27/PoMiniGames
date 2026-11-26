using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

namespace PoMiniGamesClient.Features.Shared;

/// <summary>
/// Tiny lifecycle hook placed inside a <see cref="Radzen.DialogService"/> render fragment so
/// the owning component can run DOM focus, trap, or JS-interop setup on the exact frame
/// <c>&lt;RadzenDialog /&gt;</c> commits the dialog content to the DOM.
/// </summary>
public sealed class PoDialogLifecycle : ComponentBase
{
    [Parameter] public EventCallback OnMounted { get; set; }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender && OnMounted.HasDelegate)
        {
            await OnMounted.InvokeAsync();
        }
    }
}

/// <summary>
/// Minimal host component for <see cref="Radzen.DialogService.OpenSideAsync{T}"/>, which
/// accepts a component type rather than an inline <see cref="RenderFragment"/>.
/// </summary>
public sealed class PoDialogFragmentHost : ComponentBase
{
    [Parameter] public RenderFragment? Content { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        if (Content is not null) builder.AddContent(0, Content);
    }
}
