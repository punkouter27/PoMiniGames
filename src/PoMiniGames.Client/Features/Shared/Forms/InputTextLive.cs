using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Forms;
using Microsoft.AspNetCore.Components.Rendering;

namespace PoMiniGamesClient.Features.Shared;

/// <summary>
/// An <see cref="InputText"/> that updates its value on every keystroke (<c>oninput</c>)
/// instead of on <c>change</c>, so a Submit button can enable as the player types.
/// <para>
/// <c>&lt;InputText @bind-Value="x" @bind-Value:event="oninput"&gt;</c> looks like the same
/// thing but is not: on a component it hands the string setter to the DOM's oninput event,
/// which passes a ChangeEventArgs, and the first keystroke throws ("Arg_ObjObjEx,
/// ChangeEventArgs, System.String") into the error boundary.
/// </para>
/// </summary>
public sealed class InputTextLive : InputText
{
    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        builder.OpenElement(0, "input");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        if (!string.IsNullOrEmpty(NameAttributeValue)) builder.AddAttribute(2, "name", NameAttributeValue);
        builder.AddAttribute(3, "class", CssClass);
        builder.AddAttribute(4, "value", CurrentValueAsString);
        builder.AddAttribute(5, "oninput", EventCallback.Factory.CreateBinder<string?>(this, value => CurrentValueAsString = value, CurrentValueAsString));
        builder.SetUpdatesAttributeName("value");
        builder.AddElementReferenceCapture(6, element => Element = element);
        builder.CloseElement();
    }
}
